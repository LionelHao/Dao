import { describe, expect, it, vi } from "vitest";
import { IDENTITY_IPC_CHANNELS, type IdentityPublicState } from "./contracts.js";
import { registerIdentityIpc } from "./ipc.js";

const signedOut = { status: "signed-out" } as const satisfies IdentityPublicState;
const authenticated = {
  status: "authenticated",
  accountId: "account-li",
  actorId: "human-li",
  sessions: [],
} as const satisfies IdentityPublicState;

describe("Identity IPC authority boundary", () => {
  it("registers fixed handlers, validates the trusted main frame, and closes payloads", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const removed: string[] = [];
    const mainFrame = {};
    const webContents = {
      mainFrame,
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const login = vi.fn(async () => authenticated);
    const controller = {
      getState: vi.fn(() => signedOut),
      login,
      refreshSessions: vi.fn(async () => authenticated),
      revokeSession: vi.fn(async () => authenticated),
      logout: vi.fn(async () => signedOut),
      subscribe: vi.fn(() => () => undefined),
    };
    const cleanup = registerIdentityIpc({
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
        removeHandler(channel) {
          handlers.delete(channel);
          removed.push(channel);
        },
      },
      webContents,
      controller,
    });
    const trustedEvent = { sender: webContents, senderFrame: mainFrame };

    expect([...handlers.keys()].sort()).toEqual([
      IDENTITY_IPC_CHANNELS.getState,
      IDENTITY_IPC_CHANNELS.login,
      IDENTITY_IPC_CHANNELS.logout,
      IDENTITY_IPC_CHANNELS.refreshSessions,
      IDENTITY_IPC_CHANNELS.revokeSession,
    ].sort());
    await expect(handlers.get(IDENTITY_IPC_CHANNELS.getState)?.(trustedEvent))
      .resolves.toEqual(signedOut);
    await expect(handlers.get(IDENTITY_IPC_CHANNELS.login)?.(
      trustedEvent,
      { accountId: "account-li", secret: "correct" },
    )).resolves.toEqual(authenticated);
    expect(login).toHaveBeenCalledWith({ accountId: "account-li", secret: "correct" });

    await expect(handlers.get(IDENTITY_IPC_CHANNELS.login)?.(
      trustedEvent,
      { accountId: "account-li", secret: "correct", endpoint: "ws://evil" },
    )).rejects.toThrow(/login input/i);
    await expect(handlers.get(IDENTITY_IPC_CHANNELS.getState)?.(
      trustedEvent,
      "extra",
    )).rejects.toThrow(/payload/i);
    await expect(handlers.get(IDENTITY_IPC_CHANNELS.logout)?.({
      sender: webContents,
      senderFrame: {},
    })).rejects.toThrow(/trusted main frame/i);
    expect(login).toHaveBeenCalledTimes(1);

    cleanup();
    cleanup();
    expect(removed.sort()).toEqual([...new Set(removed)].sort());
    expect(handlers.size).toBe(0);
  });

  it("broadcasts a sanitized clone and stops after teardown", () => {
    let subscriber: ((state: IdentityPublicState) => void) | undefined;
    const unsubscribe = vi.fn();
    const webContents = {
      mainFrame: {},
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const cleanup = registerIdentityIpc({
      ipcMain: { handle() {}, removeHandler() {} },
      webContents,
      controller: {
        getState: () => signedOut,
        login: async () => authenticated,
        refreshSessions: async () => authenticated,
        revokeSession: async () => authenticated,
        logout: async () => signedOut,
        subscribe(listener) {
          subscriber = listener;
          return unsubscribe;
        },
      },
    });

    subscriber?.(authenticated);
    expect(webContents.send).toHaveBeenCalledWith(
      IDENTITY_IPC_CHANNELS.stateChanged,
      authenticated,
    );
    expect(webContents.send.mock.calls[0]?.[1]).not.toBe(authenticated);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
