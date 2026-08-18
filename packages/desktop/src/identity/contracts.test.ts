import { describe, expect, it } from "vitest";
import {
  IDENTITY_IPC_CHANNELS,
  cloneIdentityPublicState,
  isIdentityLoginInput,
  isIdentityRevokeSessionInput,
  type IdentityBridge,
  type IdentityPublicState,
} from "./contracts.js";

describe("Desktop Identity public contracts", () => {
  it("accepts only closed, bounded login and revoke inputs", () => {
    expect(isIdentityLoginInput({ accountId: "human@example.test", secret: "secret" }))
      .toBe(true);
    expect(isIdentityLoginInput({ accountId: "human", secret: "secret", actorId: "agent" }))
      .toBe(false);
    expect(isIdentityLoginInput({ accountId: "", secret: "secret" })).toBe(false);
    expect(isIdentityLoginInput({ accountId: "a", secret: "x".repeat(4_097) })).toBe(false);

    expect(isIdentityRevokeSessionInput({ sessionId: "public-session-1" })).toBe(true);
    expect(isIdentityRevokeSessionInput({ sessionId: "public-session-1", endpoint: "ws://evil" }))
      .toBe(false);
    expect(isIdentityRevokeSessionInput({ sessionId: "" })).toBe(false);
  });

  it("clones and deeply freezes only the closed public state projection", () => {
    const source: IdentityPublicState = {
      status: "authenticated",
      accountId: "human@example.test",
      actorId: "human-1",
      sessions: [{
        id: "public-session-1",
        deviceLabel: "MacBook",
        platform: "macos",
        createdAt: "2026-08-18T00:00:00.000Z",
        refreshExpiresAt: "2026-09-18T00:00:00.000Z",
        current: true,
      }],
    };

    const cloned = cloneIdentityPublicState(source);

    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    expect(Object.isFrozen(cloned)).toBe(true);
    expect(cloned.status).toBe("authenticated");
    if (cloned.status !== "authenticated") throw new Error("Expected authenticated state");
    expect(Object.isFrozen(cloned.sessions)).toBe(true);
    expect(Object.isFrozen(cloned.sessions[0])).toBe(true);
    expect(JSON.stringify(cloned)).not.toMatch(/token|secret|family/i);
  });

  it("rejects a malformed state rather than forwarding extra or credential fields", () => {
    expect(() => cloneIdentityPublicState({
      status: "authenticated",
      accountId: "human",
      actorId: "human-1",
      sessions: [],
      accessToken: "canary",
    })).toThrowError(/public identity state/i);
  });

  it("publishes a fixed six-method bridge and fixed IPC channel allowlist", () => {
    const bridgeMethodNames = [
      "getState",
      "login",
      "refreshSessions",
      "revokeSession",
      "logout",
      "onStateChanged",
    ] satisfies readonly (keyof IdentityBridge)[];

    expect(bridgeMethodNames).toHaveLength(6);
    expect(Object.keys(IDENTITY_IPC_CHANNELS).sort()).toEqual([
      "getState",
      "login",
      "logout",
      "refreshSessions",
      "revokeSession",
      "stateChanged",
    ]);
    expect(Object.isFrozen(IDENTITY_IPC_CHANNELS)).toBe(true);
  });
});
