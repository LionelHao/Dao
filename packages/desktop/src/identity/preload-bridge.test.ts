import { describe, expect, it, vi } from "vitest";
import { IDENTITY_IPC_CHANNELS, type IdentityPublicState } from "./contracts.js";
import { createIdentityBridge } from "./preload-bridge.js";

describe("Identity preload bridge", () => {
  it("exposes six fixed methods without forwarding raw IPC or Electron events", async () => {
    const listeners = new Map<string, (event: unknown, state: unknown) => void>();
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IDENTITY_IPC_CHANNELS.getState) {
        return { status: "signed-out" } satisfies IdentityPublicState;
      }
      return {
        status: "authenticated",
        accountId: "account-li",
        actorId: "human-li",
        sessions: [],
      } satisfies IdentityPublicState;
    });
    const removeListener = vi.fn();
    const bridge = createIdentityBridge({
      invoke,
      on(channel, listener) {
        listeners.set(channel, listener);
      },
      removeListener,
    });

    expect(Object.keys(bridge).sort()).toEqual([
      "getState",
      "login",
      "logout",
      "onStateChanged",
      "refreshSessions",
      "revokeSession",
    ]);
    expect(Object.isFrozen(bridge)).toBe(true);
    await bridge.getState();
    await bridge.login({ accountId: "account-li", secret: "correct" });
    await bridge.refreshSessions();
    await bridge.revokeSession({ sessionId: "session-public-2" });
    await bridge.logout();
    expect(invoke.mock.calls).toEqual([
      [IDENTITY_IPC_CHANNELS.getState],
      [IDENTITY_IPC_CHANNELS.login, { accountId: "account-li", secret: "correct" }],
      [IDENTITY_IPC_CHANNELS.refreshSessions],
      [IDENTITY_IPC_CHANNELS.revokeSession, { sessionId: "session-public-2" }],
      [IDENTITY_IPC_CHANNELS.logout],
    ]);

    const states: IdentityPublicState[] = [];
    const unsubscribe = bridge.onStateChanged((state) => states.push(state));
    listeners.get(IDENTITY_IPC_CHANNELS.stateChanged)?.(
      { sender: "must-not-cross" },
      { status: "revoked" },
    );
    expect(states).toEqual([{ status: "revoked" }]);
    expect(JSON.stringify(states)).not.toContain("must-not-cross");
    unsubscribe();
    unsubscribe();
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it("rejects non-closed inputs before invoking main", async () => {
    const invoke = vi.fn();
    const bridge = createIdentityBridge({
      invoke,
      on() {},
      removeListener() {},
    });

    await expect(bridge.login({
      accountId: "account-li",
      secret: "correct",
      endpoint: "ws://evil",
    } as never)).rejects.toThrow(/login input/i);
    await expect(bridge.revokeSession({ sessionId: "" })).rejects.toThrow(/revoke input/i);
    expect(invoke).not.toHaveBeenCalled();
  });
});
