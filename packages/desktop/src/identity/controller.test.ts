import { describe, expect, it, vi } from "vitest";
import type { IdentityPublicSession, IdentityStoredCredentials } from "./contracts.js";
import type { IdentityCredentialVault } from "./credential-vault.js";
import { CredentialVaultError } from "./credential-vault.js";
import {
  createIdentitySessionController,
  type AuthorizedStateInvalidator,
} from "./controller.js";
import type { DeviceIdentityStore } from "./device-identity.js";
import {
  IdentityTransportError,
  type IdentityIssuedSession,
  type IdentityWebSocketClient,
} from "./websocket-client.js";

const stored: IdentityStoredCredentials = {
  version: 1,
  accountId: "account-li",
  actorId: "human-li",
  sessionId: "session-current",
  accessToken: "access-canary",
  refreshToken: "refresh-canary",
  expiresAt: "2026-08-18T00:15:00.000Z",
  refreshExpiresAt: "2026-09-18T00:00:00.000Z",
};

const issued: IdentityIssuedSession = {
  accountId: stored.accountId,
  actorId: stored.actorId,
  sessionId: stored.sessionId,
  accessToken: "access-rotated",
  refreshToken: "refresh-rotated",
  expiresAt: "2026-08-18T00:30:00.000Z",
  refreshExpiresAt: "2026-09-18T00:15:00.000Z",
};

const currentSession: IdentityPublicSession = {
  id: stored.sessionId,
  deviceLabel: "MacBook",
  platform: "macos",
  createdAt: "2026-08-18T00:00:00.000Z",
  refreshExpiresAt: stored.refreshExpiresAt,
  current: true,
};

function fakeVault(initial: IdentityStoredCredentials | undefined, order: string[] = []) {
  let value = initial;
  const vault: IdentityCredentialVault = {
    load: vi.fn(async () => value),
    save: vi.fn(async (next) => {
      order.push("vault.save");
      value = next;
    }),
    clear: vi.fn(async () => {
      order.push("vault.clear");
      value = undefined;
    }),
  };
  return { vault, read: () => value };
}

function fakeClient(overrides: Partial<IdentityWebSocketClient> = {}, order: string[] = []) {
  let terminal: ((eventId: string) => void) | undefined;
  let connectionFailure: ((error: IdentityTransportError) => void) | undefined;
  const client: IdentityWebSocketClient = {
    connect: vi.fn(async () => undefined),
    login: vi.fn(async () => issued),
    resume: vi.fn(async () => ({
      accountId: stored.accountId,
      actorId: stored.actorId,
      sessionId: stored.sessionId,
    })),
    refresh: vi.fn(async () => issued),
    listSessions: vi.fn(async () => [currentSession]),
    revokeSession: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    onTerminalRevoked: vi.fn((listener) => {
      terminal = listener;
      return () => {
        terminal = undefined;
      };
    }),
    onConnectionFailure: vi.fn((listener) => {
      connectionFailure = listener;
      return () => {
        connectionFailure = undefined;
      };
    }),
    close: vi.fn(() => {
      order.push("client.close");
    }),
    ...overrides,
  };
  return {
    client,
    terminal: (eventId = "event-revoked") => terminal?.(eventId),
    connectionFailure: (
      error = new IdentityTransportError("connection_unavailable"),
    ) => connectionFailure?.(error),
  };
}

function fakeDevice(): DeviceIdentityStore {
  return {
    loadOrCreate: vi.fn(async () => ({
      id: "installation-1",
      label: "MacBook",
      platform: "macos" as const,
    })),
  };
}

function invalidator(order: string[] = []): AuthorizedStateInvalidator & {
  readonly invalidate: ReturnType<typeof vi.fn>;
} {
  return {
    invalidate: vi.fn(async () => {
      order.push("authorized.invalidate");
    }),
  };
}

describe("IdentitySessionController startup", () => {
  it("closes no-credential startup as signed-out without opening transport", async () => {
    const { vault } = fakeVault(undefined);
    const clientFactory = vi.fn(() => fakeClient().client);
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory,
      authorizedState: invalidator(),
    });

    await expect(controller.initialize()).resolves.toEqual({ status: "signed-out" });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("restores valid access, verifies the public session id, and publishes no token", async () => {
    const { vault } = fakeVault(stored);
    const { client } = fakeClient();
    const states: unknown[] = [];
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState: invalidator(),
    });
    controller.subscribe((state) => states.push(state));

    const state = await controller.initialize();

    expect(client.resume).toHaveBeenCalledWith(stored.accessToken);
    expect(state).toMatchObject({ status: "authenticated", accountId: stored.accountId });
    expect(states.map((value) => (value as { status: string }).status))
      .toEqual(["restoring", "authenticated"]);
    expect(JSON.stringify(states)).not.toMatch(/access-canary|refresh-canary/);
  });

  it("refreshes expired access exactly once, saves rotation, then authenticates", async () => {
    const order: string[] = [];
    const { vault, read } = fakeVault(stored, order);
    const { client } = fakeClient({
      resume: vi.fn(async () => {
        throw new IdentityTransportError("token_expired", 401);
      }),
      refresh: vi.fn(async () => {
        order.push("client.refresh");
        return issued;
      }),
      listSessions: vi.fn(async () => {
        order.push("client.list");
        return [{ ...currentSession, refreshExpiresAt: issued.refreshExpiresAt }];
      }),
    });
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState: invalidator(),
    });

    await expect(controller.initialize()).resolves.toMatchObject({ status: "authenticated" });
    expect(client.refresh).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["client.refresh", "vault.save", "client.list"]);
    expect(read()).toEqual({ version: 1, ...issued });
  });

  it("fails closed with a storage error when refresh rotation cannot be saved", async () => {
    const order: string[] = [];
    const { vault } = fakeVault(stored, order);
    vi.mocked(vault.save).mockImplementationOnce(async () => {
      order.push("vault.save.failed");
      throw new CredentialVaultError("credential_vault_io");
    });
    const { client } = fakeClient({
      resume: vi.fn(async () => {
        throw new IdentityTransportError("token_expired", 401);
      }),
      refresh: vi.fn(async () => {
        order.push("client.refresh");
        return issued;
      }),
      logout: vi.fn(async () => {
        order.push("client.logout");
        throw new IdentityTransportError("connection_unavailable");
      }),
    }, order);
    const authorizedState = invalidator(order);
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState,
    });

    await expect(controller.initialize()).resolves.toMatchObject({
      status: "fatal",
      error: { code: "credential_storage_unavailable" },
    });
    expect(client.logout).toHaveBeenCalledOnce();
    expect(vault.clear).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "client.refresh",
      "vault.save.failed",
      "client.logout",
      "client.close",
      "vault.clear",
      "authorized.invalidate",
    ]);
  });

  it("clears a revoked refresh and transitions to revoked", async () => {
    const { vault, read } = fakeVault(stored);
    const authorizedState = invalidator();
    const { client } = fakeClient({
      resume: vi.fn(async () => {
        throw new IdentityTransportError("token_expired", 401);
      }),
      refresh: vi.fn(async () => {
        throw new IdentityTransportError("session_revoked", 403);
      }),
    });
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState,
    });

    await expect(controller.initialize()).resolves.toEqual({
      status: "revoked",
      accountId: stored.accountId,
    });
    expect(read()).toBeUndefined();
    expect(authorizedState.invalidate).toHaveBeenCalledOnce();
  });

  it("retains encrypted credentials and exposes unavailable on a network failure", async () => {
    const { vault, read } = fakeVault(stored);
    const { client } = fakeClient({
      connect: vi.fn(async () => {
        throw new IdentityTransportError("connection_unavailable");
      }),
    });
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState: invalidator(),
    });

    await expect(controller.initialize()).resolves.toMatchObject({ status: "unavailable" });
    expect(read()).toEqual(stored);
    expect(vault.clear).not.toHaveBeenCalled();
  });

  it("locks the readable public state before awaiting unavailable invalidation", async () => {
    let releaseInvalidation: (() => void) | undefined;
    const invalidationBlocked = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });
    const { vault } = fakeVault(stored);
    const authorizedState: AuthorizedStateInvalidator = {
      invalidate: vi.fn(() => invalidationBlocked),
    };
    const { client } = fakeClient({
      connect: vi.fn(async () => {
        throw new IdentityTransportError("connection_unavailable");
      }),
    });
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState,
    });

    const initializing = controller.initialize();
    await vi.waitFor(() => expect(authorizedState.invalidate).toHaveBeenCalledOnce());
    expect(controller.getState()).toEqual({ status: "starting" });
    releaseInvalidation?.();
    await expect(initializing).resolves.toMatchObject({ status: "unavailable" });
  });

  it("locks the readable public state before awaiting fatal credential cleanup", async () => {
    let releaseClear: (() => void) | undefined;
    const clearBlocked = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const { vault } = fakeVault(stored);
    vi.mocked(vault.clear).mockImplementationOnce(() => clearBlocked);
    const { client } = fakeClient({
      resume: vi.fn(async () => ({
        accountId: stored.accountId,
        actorId: stored.actorId,
        sessionId: "mismatched-session",
      })),
    });
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState: invalidator(),
    });

    const initializing = controller.initialize();
    await vi.waitFor(() => expect(vault.clear).toHaveBeenCalledOnce());
    expect(controller.getState()).toEqual({ status: "starting" });
    releaseClear?.();
    await expect(initializing).resolves.toMatchObject({ status: "fatal" });
  });

  it("fails corrupt/unavailable storage as fatal without opening transport", async () => {
    const { vault } = fakeVault(undefined);
    vi.mocked(vault.load).mockRejectedValueOnce(
      new CredentialVaultError("credential_vault_corrupt"),
    );
    const clientFactory = vi.fn(() => fakeClient().client);
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory,
      authorizedState: invalidator(),
    });

    await expect(controller.initialize()).resolves.toMatchObject({
      status: "fatal",
      error: { code: "credential_storage_corrupt" },
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });
});

describe("IdentitySessionController commands", () => {
  it("durably saves login credentials before publishing authenticated", async () => {
    const order: string[] = [];
    const { vault } = fakeVault(undefined, order);
    const { client } = fakeClient({
      listSessions: vi.fn(async () => {
        order.push("client.list");
        return [{ ...currentSession, refreshExpiresAt: issued.refreshExpiresAt }];
      }),
    });
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState: invalidator(),
    });
    controller.subscribe((state) => order.push(`state.${state.status}`));
    await controller.initialize();
    order.length = 0;

    await controller.login({ accountId: stored.accountId, secret: "password-canary" });

    expect(order).toEqual([
      "state.authenticating",
      "vault.save",
      "client.list",
      "state.authenticated",
    ]);
    expect(JSON.stringify(controller.getState())).not.toContain("password-canary");
  });

  it("best-effort revokes and fails closed when login credential persistence fails", async () => {
    const { vault } = fakeVault(undefined);
    vi.mocked(vault.save).mockRejectedValueOnce(
      new CredentialVaultError("credential_vault_io"),
    );
    const authorizedState = invalidator();
    const { client } = fakeClient();
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState,
    });
    await controller.initialize();

    await expect(controller.login({ accountId: stored.accountId, secret: "correct" }))
      .resolves.toMatchObject({ status: "fatal" });
    expect(client.logout).toHaveBeenCalledOnce();
    expect(vault.clear).toHaveBeenCalledOnce();
    expect(authorizedState.invalidate).toHaveBeenCalledOnce();
  });

  it("returns a bounded signed-out error when the active session limit is reached", async () => {
    const { vault } = fakeVault(undefined);
    const { client } = fakeClient({
      login: vi.fn(async () => {
        throw new IdentityTransportError("session_limit_reached", 409);
      }),
    });
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState: invalidator(),
    });
    await controller.initialize();

    await expect(controller.login({ accountId: stored.accountId, secret: "correct" }))
      .resolves.toEqual({
        status: "signed-out",
        accountId: stored.accountId,
        error: {
          code: "session_limit_reached",
          message: "活跃设备会话已达上限，请先在其他设备退出登录。",
        },
      });
    expect(vault.save).not.toHaveBeenCalled();
  });

  it("refreshes the list after a correlated remote session revoke ACK", async () => {
    const { vault } = fakeVault(stored);
    const remaining = [{ ...currentSession }];
    const { client } = fakeClient({ listSessions: vi.fn(async () => remaining) });
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState: invalidator(),
    });
    await controller.initialize();

    await expect(controller.revokeSession({ sessionId: "session-other" }))
      .resolves.toMatchObject({ status: "authenticated", sessions: remaining });
    expect(client.revokeSession).toHaveBeenCalledWith("session-other");
    expect(client.listSessions).toHaveBeenCalledTimes(2);
  });

  it("does not replace retained unavailable credentials with a new login attempt", async () => {
    const { vault, read } = fakeVault(stored);
    const { client } = fakeClient({
      connect: vi.fn(async () => {
        throw new IdentityTransportError("connection_unavailable");
      }),
    });
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState: invalidator(),
    });
    await controller.initialize();

    await expect(controller.login({ accountId: "new-account", secret: "wrong" }))
      .rejects.toMatchObject({ code: "identity_invalid_state" });
    expect(controller.getState()).toMatchObject({
      status: "unavailable",
      accountId: stored.accountId,
    });
    expect(read()).toEqual(stored);
    expect(client.login).not.toHaveBeenCalled();
  });

  it("requires current-device termination to use logout, not targeted revoke", async () => {
    const { vault } = fakeVault(stored);
    const { client } = fakeClient();
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState: invalidator(),
    });
    await controller.initialize();

    await expect(controller.revokeSession({ sessionId: stored.sessionId }))
      .rejects.toMatchObject({ code: "identity_invalid_state" });
    expect(client.revokeSession).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({ status: "authenticated" });
  });

  it("handles terminal remote revoke in close → clear → invalidate → public-state order", async () => {
    const order: string[] = [];
    const { vault } = fakeVault(stored, order);
    const authorizedState = invalidator(order);
    const harness = fakeClient({}, order);
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => harness.client,
      authorizedState,
    });
    controller.subscribe((state) => {
      if (state.status === "revoked") order.push("state.revoked");
    });
    await controller.initialize();
    order.length = 0;

    harness.terminal();
    await controller.refreshSessions();

    expect(order).toEqual([
      "client.close",
      "vault.clear",
      "authorized.invalidate",
      "state.revoked",
    ]);
    expect(controller.getState()).toEqual({ status: "revoked", accountId: stored.accountId });
  });

  it("locks an idle authenticated controller when its transport disconnects", async () => {
    const { vault, read } = fakeVault(stored);
    const authorizedState = invalidator();
    const harness = fakeClient();
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => harness.client,
      authorizedState,
    });
    await controller.initialize();

    harness.connectionFailure();
    await vi.waitFor(() => {
      expect(controller.getState()).toMatchObject({ status: "unavailable" });
    });
    expect(read()).toEqual(stored);
    expect(authorizedState.invalidate).toHaveBeenCalledOnce();
  });

  it("treats the production terminal logout frame as committed logout, not remote revoke", async () => {
    const { vault, read } = fakeVault(stored);
    const { client } = fakeClient({
      logout: vi.fn(async () => {
        throw new IdentityTransportError("session_revoked", 403);
      }),
    });
    const controller = createIdentitySessionController({
      vault,
      deviceIdentity: fakeDevice(),
      clientFactory: () => client,
      authorizedState: invalidator(),
    });
    await controller.initialize();

    await expect(controller.logout()).resolves.toEqual({
      status: "signed-out",
      accountId: stored.accountId,
    });
    expect(read()).toBeUndefined();
  });
});
