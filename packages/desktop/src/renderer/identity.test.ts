import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IdentityBridge,
  IdentityPublicState,
} from "../identity/contracts.js";
import { mountIdentityApp } from "./identity.js";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function bridgeFixture(
  initial: Promise<IdentityPublicState> | IdentityPublicState,
): {
  readonly bridge: IdentityBridge;
  emit(state: IdentityPublicState): void;
  readonly login: ReturnType<typeof vi.fn>;
  readonly refreshSessions: ReturnType<typeof vi.fn>;
  readonly revokeSession: ReturnType<typeof vi.fn>;
  readonly logout: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: ((state: IdentityPublicState) => void) | undefined;
  const unsubscribe = vi.fn();
  const login = vi.fn();
  const refreshSessions = vi.fn();
  const revokeSession = vi.fn();
  const logout = vi.fn();
  return {
    bridge: {
      getState: vi.fn(async () => initial),
      login,
      refreshSessions,
      revokeSession,
      logout,
      onStateChanged(nextListener) {
        listener = nextListener;
        return unsubscribe;
      },
    },
    emit(state) {
      listener?.(state);
    },
    login,
    refreshSessions,
    revokeSession,
    logout,
    unsubscribe,
  };
}

const authenticated = {
  status: "authenticated",
  accountId: "account-li",
  actorId: "human-li",
  sessions: [
    {
      id: "session-mac",
      deviceLabel: "MacBook Pro",
      platform: "macos",
      createdAt: "2026-08-18T00:00:00.000Z",
      refreshExpiresAt: "2026-09-17T00:00:00.000Z",
      current: true,
    },
    {
      id: "session-imac",
      deviceLabel: "iMac",
      platform: "macos",
      createdAt: "2026-08-17T00:00:00.000Z",
      refreshExpiresAt: "2026-09-16T00:00:00.000Z",
      current: false,
    },
  ],
} as const satisfies IdentityPublicState;

afterEach(() => {
  document.body.replaceChildren();
});

describe("live Identity renderer", () => {
  it("renders a startup skeleton before resolved auth state and never flashes sessions", async () => {
    const state = deferred<IdentityPublicState>();
    const fixture = bridgeFixture(state.promise);
    const root = document.createElement("main");

    mountIdentityApp(root, fixture.bridge);
    expect(root.dataset.identityStatus).toBe("starting");
    expect(root.textContent).toContain("正在检查登录状态");
    expect(root.textContent).not.toContain("设备会话");

    state.resolve({ status: "signed-out" });
    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("signed-out"));
    expect(root.querySelector("form[data-identity-login]")).not.toBeNull();
    expect(root.textContent).not.toContain("Agent 登录");
  });

  it("submits Human credentials once, clears the password, and waits for authority result", async () => {
    const fixture = bridgeFixture({ status: "signed-out" });
    const loginResult = deferred<IdentityPublicState>();
    fixture.login.mockReturnValue(loginResult.promise);
    const root = document.createElement("main");
    document.body.append(root);
    mountIdentityApp(root, fixture.bridge);
    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("signed-out"));
    const form = root.querySelector<HTMLFormElement>("form[data-identity-login]")!;
    const account = form.elements.namedItem("accountId") as HTMLInputElement;
    const password = form.elements.namedItem("secret") as HTMLInputElement;
    account.value = "account-li";
    password.value = "password-dom-canary-FT01";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(fixture.login).toHaveBeenCalledWith({
      accountId: "account-li",
      secret: "password-dom-canary-FT01",
    });
    expect(password.value).toBe("");
    expect(root.innerHTML).not.toContain("password-dom-canary-FT01");
    expect(root.dataset.identityStatus).toBe("authenticating");
    expect(root.querySelector("button[type='submit']")?.hasAttribute("disabled")).toBe(true);
    expect(root.textContent).not.toContain("设备会话");

    loginResult.resolve({
      status: "signed-out",
      accountId: "account-li",
      error: { code: "invalid_credentials", message: "账户或密码不正确" },
    });
    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("signed-out"));
    expect((root.querySelector("input[name='accountId']") as HTMLInputElement).value)
      .toBe("account-li");
    expect(root.textContent).toContain("账户或密码不正确");
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(root.querySelector("[role='alert']"));
    });
  });

  it("marks the current device, waits for revoke ACK, and does not remove optimistically", async () => {
    const fixture = bridgeFixture(authenticated);
    const revokeResult = deferred<IdentityPublicState>();
    fixture.revokeSession.mockReturnValue(revokeResult.promise);
    const root = document.createElement("main");
    mountIdentityApp(root, fixture.bridge);
    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("authenticated"));

    const current = root.querySelector<HTMLElement>("[data-session-id='session-mac']")!;
    const remote = root.querySelector<HTMLElement>("[data-session-id='session-imac']")!;
    expect(current.textContent).toContain("当前设备");
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.querySelector("button[data-revoke-session]")).toBeNull();
    const revoke = remote.querySelector<HTMLButtonElement>("button[data-revoke-session]")!;
    revoke.click();
    expect(fixture.revokeSession).toHaveBeenCalledWith({ sessionId: "session-imac" });
    expect(revoke.disabled).toBe(true);
    expect(root.querySelector("[data-session-id='session-imac']")).not.toBeNull();

    revokeResult.resolve({
      ...authenticated,
      sessions: [authenticated.sessions[0]],
    });
    await vi.waitFor(() => {
      expect(root.querySelector("[data-session-id='session-imac']")).toBeNull();
    });
    expect(root.dataset.identityStatus).toBe("authenticated");
  });

  it("does not retain a submitted password canary after successful login", async () => {
    const fixture = bridgeFixture({ status: "signed-out" });
    fixture.login.mockResolvedValue(authenticated);
    const root = document.createElement("main");
    document.body.append(root);
    mountIdentityApp(root, fixture.bridge);
    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("signed-out"));
    const form = root.querySelector<HTMLFormElement>("form[data-identity-login]")!;
    const account = form.elements.namedItem("accountId") as HTMLInputElement;
    const password = form.elements.namedItem("secret") as HTMLInputElement;
    account.value = "account-li";
    password.value = "password-success-dom-canary-FT01";

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("authenticated"));
    expect(root.innerHTML).not.toContain("password-success-dom-canary-FT01");
    expect(root.textContent).not.toContain("password-success-dom-canary-FT01");
  });

  it("retains and re-enables the exact target when remote revoke fails", async () => {
    const fixture = bridgeFixture(authenticated);
    const revokeResult = deferred<IdentityPublicState>();
    fixture.revokeSession.mockReturnValue(revokeResult.promise);
    const root = document.createElement("main");
    document.body.append(root);
    mountIdentityApp(root, fixture.bridge);
    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("authenticated"));

    const target = root.querySelector<HTMLElement>("[data-session-id='session-imac']")!;
    const revoke = target.querySelector<HTMLButtonElement>("button[data-revoke-session]")!;
    expect(revoke.getAttribute("aria-label")).toContain("iMac");
    revoke.click();
    revokeResult.reject(new Error("raw transport detail must not render"));

    await vi.waitFor(() => {
      expect(root.querySelector("[data-session-id='session-imac']")).not.toBeNull();
      expect(root.querySelector("[data-session-id='session-mac']")).not.toBeNull();
      expect(root.querySelector<HTMLButtonElement>(
        "[data-session-id='session-imac'] button[data-revoke-session]",
      )?.disabled).toBe(false);
      expect(root.querySelector("[data-session-id='session-imac'] [role='alert']")?.textContent)
        .toContain("撤销未完成");
    });
    expect(root.textContent).not.toContain("raw transport detail");
    expect(document.activeElement).toBe(
      root.querySelector("[data-session-id='session-imac'] [role='alert']"),
    );
    root.remove();
  });

  it("provides programmatic labels and predictable initial focus", async () => {
    const fixture = bridgeFixture({ status: "signed-out", accountId: "account-li" });
    const root = document.createElement("main");
    document.body.append(root);
    mountIdentityApp(root, fixture.bridge);
    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("signed-out"));

    const account = root.querySelector<HTMLInputElement>("input[name='accountId']")!;
    const password = root.querySelector<HTMLInputElement>("input[name='secret']")!;
    expect(account.labels?.[0]?.textContent).toContain("账户");
    expect(password.labels?.[0]?.textContent).toContain("密码");
    await vi.waitFor(() => expect(document.activeElement).toBe(account));
    root.remove();
  });

  it("removes authenticated content immediately on terminal revocation", async () => {
    const fixture = bridgeFixture(authenticated);
    const root = document.createElement("main");
    const dispose = mountIdentityApp(root, fixture.bridge);
    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("authenticated"));
    expect(root.textContent).toContain("设备会话");

    fixture.emit({ status: "revoked", accountId: "account-li" });
    expect(root.dataset.identityStatus).toBe("revoked");
    expect(root.textContent).not.toContain("MacBook Pro");
    expect(root.textContent).toContain("此设备的会话已撤销");
    expect(root.querySelector("form[data-identity-login]")).not.toBeNull();

    dispose();
    dispose();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });

  it("offers finite retry/logout actions and announces state changes accessibly", async () => {
    const fixture = bridgeFixture({
      status: "unavailable",
      accountId: "account-li",
      error: { code: "unavailable", message: "服务暂时不可用" },
    });
    fixture.refreshSessions.mockResolvedValue(authenticated);
    fixture.logout.mockResolvedValue({ status: "signed-out", accountId: "account-li" });
    const root = document.createElement("main");
    mountIdentityApp(root, fixture.bridge);
    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("unavailable"));
    expect(root.querySelector("[role='status'][aria-live='polite']")).not.toBeNull();
    const retry = [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "重试连接")!;
    retry.click();
    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("authenticated"));
    expect(fixture.refreshSessions).toHaveBeenCalledOnce();
    const logout = root.querySelector<HTMLButtonElement>("button[data-identity-logout]")!;
    logout.click();
    await vi.waitFor(() => expect(root.dataset.identityStatus).toBe("signed-out"));
    expect(fixture.logout).toHaveBeenCalledOnce();
  });
});
