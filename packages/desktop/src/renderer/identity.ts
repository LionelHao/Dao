import type {
  IdentityBridge,
  IdentityPublicSession,
  IdentityPublicState,
} from "../identity/contracts.js";

function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string,
): HTMLElementTagNameMap[Tag] {
  const value = document.createElement(tag);
  if (className !== undefined) value.className = className;
  return value;
}

function text<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  content: string,
  className?: string,
): HTMLElementTagNameMap[Tag] {
  const value = element(tag, className);
  value.textContent = content;
  return value;
}

function platformLabel(platform: IdentityPublicSession["platform"]): string {
  switch (platform) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
    case "unknown":
      return "未知平台";
  }
}

function safeFailureState(
  current: IdentityPublicState,
  message: string,
): IdentityPublicState {
  if (current.status === "authenticated") {
    return {
      status: "unavailable",
      accountId: current.accountId,
      error: { code: "unavailable", message },
    };
  }
  const accountId = "accountId" in current ? current.accountId : undefined;
  return {
    status: "signed-out",
    ...(accountId === undefined ? {} : { accountId }),
    error: { code: "internal_error", message },
  };
}

export function mountIdentityApp(root: HTMLElement, bridge: IdentityBridge): () => void {
  let disposed = false;
  let operationGeneration = 0;
  let currentState: IdentityPublicState = { status: "starting" };
  let sessionActionError: { readonly sessionId: string; readonly message: string } | undefined;

  const focusAfterRender = (target: HTMLElement): void => {
    queueMicrotask(() => {
      if (!disposed && target.isConnected) target.focus();
    });
  };

  const startOperation = (
    operation: () => Promise<IdentityPublicState>,
    pending?: IdentityPublicState,
    onFailure?: () => void,
  ): void => {
    const generation = ++operationGeneration;
    if (pending !== undefined) render(pending);
    void operation().then(
      (state) => {
        if (!disposed && generation === operationGeneration) {
          sessionActionError = undefined;
          render(state);
        }
      },
      () => {
        if (!disposed && generation === operationGeneration) {
          if (onFailure === undefined) {
            render(safeFailureState(currentState, "操作未完成，请重试"));
          } else {
            onFailure();
          }
        }
      },
    );
  };

  const appendLoginForm = (
    container: HTMLElement,
    accountId: string | undefined,
    busy: boolean,
    focusAccount = true,
  ): void => {
    const form = element("form", "identity-login");
    form.dataset.identityLogin = "true";
    const accountLabel = text("label", "账户", "identity-field");
    const account = element("input");
    account.name = "accountId";
    account.type = "text";
    account.autocomplete = "username";
    account.required = true;
    account.maxLength = 256;
    account.value = accountId ?? "";
    account.disabled = busy;
    accountLabel.append(account);
    const passwordLabel = text("label", "密码", "identity-field");
    const password = element("input");
    password.name = "secret";
    password.type = "password";
    password.autocomplete = "current-password";
    password.required = true;
    password.maxLength = 4_096;
    password.disabled = busy;
    passwordLabel.append(password);
    const submit = text("button", busy ? "正在登录…" : "登录", "identity-primary-action");
    submit.type = "submit";
    submit.disabled = busy;
    form.append(accountLabel, passwordLabel, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) return;
      const nextAccountId = account.value;
      const secret = password.value;
      password.value = "";
      if (nextAccountId.length === 0 || secret.length === 0) return;
      startOperation(
        () => bridge.login({ accountId: nextAccountId, secret }),
        { status: "authenticating", accountId: nextAccountId },
      );
    });
    container.append(form);
    if (!busy && focusAccount) focusAfterRender(account);
  };

  const appendError = (
    container: HTMLElement,
    error: { readonly message: string } | undefined,
  ): void => {
    if (error === undefined) return;
    const alert = text("p", error.message, "identity-error");
    alert.setAttribute("role", "alert");
    alert.tabIndex = -1;
    container.append(alert);
    focusAfterRender(alert);
  };

  const renderSession = (session: IdentityPublicSession): HTMLElement => {
    const item = element("li", "identity-session");
    item.dataset.sessionId = session.id;
    if (session.current) {
      item.dataset.current = "true";
      item.setAttribute("aria-current", "true");
    }
    const heading = text("h3", session.deviceLabel);
    const metadata = text(
      "p",
      `${platformLabel(session.platform)} · 有效至 ${session.refreshExpiresAt}`,
      "identity-session__metadata",
    );
    item.append(heading, metadata);
    if (session.current) {
      const current = text("strong", "当前设备", "identity-session__current");
      item.append(current);
    } else {
      const revoke = text("button", "撤销此设备", "identity-danger-action");
      revoke.type = "button";
      revoke.dataset.revokeSession = "true";
      revoke.setAttribute("aria-label", `撤销 ${session.deviceLabel} 的设备会话`);
      revoke.addEventListener("click", () => {
        sessionActionError = undefined;
        revoke.disabled = true;
        revoke.textContent = "正在撤销…";
        startOperation(
          () => bridge.revokeSession({ sessionId: session.id }),
          undefined,
          () => {
            sessionActionError = {
              sessionId: session.id,
              message: "撤销未完成，此设备会话仍然保留。请重试。",
            };
            render(currentState);
          },
        );
      }, { once: true });
      item.append(revoke);
      if (sessionActionError?.sessionId === session.id) {
        const failure = text("p", sessionActionError.message, "identity-session__error");
        failure.setAttribute("role", "alert");
        failure.tabIndex = -1;
        item.append(failure);
        focusAfterRender(failure);
      }
    }
    return item;
  };

  const render = (state: IdentityPublicState): void => {
    if (disposed) return;
    if (state.status !== "authenticated" || (sessionActionError !== undefined &&
        !state.sessions.some((session) => session.id === sessionActionError?.sessionId))) {
      sessionActionError = undefined;
    }
    currentState = state;
    root.dataset.identityStatus = state.status;
    root.setAttribute("aria-label", "身份与设备会话");
    const shell = element("section", "identity-shell");
    const status = text("p", "", "identity-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    shell.append(status);

    switch (state.status) {
      case "starting":
        status.textContent = "正在检查登录状态…";
        shell.append(text("h1", "原生人机协作 IM"));
        break;
      case "restoring":
        status.textContent = "正在恢复安全会话…";
        shell.append(text("h1", "恢复登录"));
        break;
      case "authenticating":
        status.textContent = "正在验证 Human 账户…";
        shell.append(text("h1", "Human 登录"));
        appendLoginForm(shell, state.accountId, true);
        break;
      case "signed-out":
        status.textContent = "尚未登录";
        shell.append(text("h1", "Human 登录"));
        shell.append(text(
          "p",
          "使用部署方提供的 Human 账户登录。Agent 没有密码登录入口。",
          "identity-explanation",
        ));
        appendError(shell, state.error);
        appendLoginForm(shell, state.accountId, false, state.error === undefined);
        break;
      case "authenticated": {
        status.textContent = `已认证 · ${state.accountId}`;
        shell.append(text("h1", "设备会话"));
        shell.append(text(
          "p",
          "每台设备使用独立会话。撤销其他设备不会退出当前设备。",
          "identity-explanation",
        ));
        const list = element("ul", "identity-session-list");
        list.setAttribute("aria-label", "已登录设备");
        for (const session of state.sessions) list.append(renderSession(session));
        shell.append(list);
        const actions = element("div", "identity-actions");
        const refresh = text("button", "刷新设备列表");
        refresh.type = "button";
        refresh.addEventListener("click", () => {
          refresh.disabled = true;
          startOperation(() => bridge.refreshSessions());
        }, { once: true });
        const logout = text("button", "退出当前设备", "identity-danger-action");
        logout.type = "button";
        logout.dataset.identityLogout = "true";
        logout.addEventListener("click", () => {
          logout.disabled = true;
          startOperation(() => bridge.logout());
        }, { once: true });
        actions.append(refresh, logout);
        shell.append(actions);
        break;
      }
      case "unavailable": {
        status.textContent = "服务暂时不可用";
        shell.append(text("h1", "无法连接身份服务"));
        appendError(shell, state.error);
        const retry = text("button", "重试连接", "identity-primary-action");
        retry.type = "button";
        retry.addEventListener("click", () => {
          retry.disabled = true;
          startOperation(() => bridge.refreshSessions(), {
            status: "restoring",
            ...(state.accountId === undefined ? {} : { accountId: state.accountId }),
          });
        }, { once: true });
        shell.append(retry);
        break;
      }
      case "revoked":
        status.textContent = "会话已撤销";
        shell.append(text("h1", "此设备的会话已撤销"));
        shell.append(text(
          "p",
          "本地凭据已清除。重新登录会建立新的独立设备会话。",
          "identity-explanation",
        ));
        appendLoginForm(shell, state.accountId, false);
        break;
      case "fatal":
        status.textContent = "身份存储不可用";
        shell.append(text("h1", "无法安全启动"));
        appendError(shell, state.error);
        shell.append(text(
          "p",
          "为避免明文保存凭据，应用已停止登录。请修复系统安全存储后重启。",
          "identity-explanation",
        ));
        break;
    }
    root.replaceChildren(shell);
  };

  render(currentState);
  const unsubscribe = bridge.onStateChanged((state) => {
    operationGeneration += 1;
    render(state);
  });
  const initialGeneration = operationGeneration;
  void bridge.getState().then(
    (state) => {
      if (!disposed && initialGeneration === operationGeneration) render(state);
    },
    () => {
      if (!disposed && initialGeneration === operationGeneration) {
        render({
          status: "fatal",
          error: { code: "internal_error", message: "无法读取身份状态" },
        });
      }
    },
  );

  return () => {
    if (disposed) return;
    disposed = true;
    operationGeneration += 1;
    unsubscribe();
  };
}
