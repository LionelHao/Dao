import {
  IDENTITY_IPC_CHANNELS,
  cloneIdentityPublicState,
  isIdentityLoginInput,
  isIdentityRevokeSessionInput,
  type IdentityLoginInput,
  type IdentityPublicState,
  type IdentityRevokeSessionInput,
} from "./contracts.js";

interface IdentityIpcEvent {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}
export interface IdentityIpcMain {
  handle(
    channel: string,
    handler: (event: IdentityIpcEvent, ...args: unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface IdentityIpcWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, state: IdentityPublicState): void;
}

export interface IdentityControllerPort {
  getState(): IdentityPublicState | Promise<IdentityPublicState>;
  login(input: IdentityLoginInput): Promise<IdentityPublicState>;
  refreshSessions(): Promise<IdentityPublicState>;
  revokeSession(input: IdentityRevokeSessionInput): Promise<IdentityPublicState>;
  logout(): Promise<IdentityPublicState>;
  subscribe(listener: (state: IdentityPublicState) => void): () => void;
}

export interface RegisterIdentityIpcOptions {
  readonly ipcMain: IdentityIpcMain;
  readonly webContents: IdentityIpcWebContents;
  readonly controller: IdentityControllerPort;
}

function requireTrustedMainFrame(
  event: IdentityIpcEvent,
  webContents: IdentityIpcWebContents,
): void {
  if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
    throw new TypeError("Identity IPC requires the trusted main frame");
  }
}

function requireNoPayload(args: readonly unknown[]): void {
  if (args.length !== 0) {
    throw new TypeError("Identity IPC method does not accept a payload");
  }
}

export function registerIdentityIpc(options: RegisterIdentityIpcOptions): () => void {
  const channels = [
    IDENTITY_IPC_CHANNELS.getState,
    IDENTITY_IPC_CHANNELS.login,
    IDENTITY_IPC_CHANNELS.refreshSessions,
    IDENTITY_IPC_CHANNELS.revokeSession,
    IDENTITY_IPC_CHANNELS.logout,
  ] as const;

  const register = (
    channel: (typeof channels)[number],
    operation: (args: readonly unknown[]) => IdentityPublicState | Promise<IdentityPublicState>,
  ): void => {
    options.ipcMain.handle(channel, async (event, ...args) => {
      requireTrustedMainFrame(event, options.webContents);
      return cloneIdentityPublicState(await operation(args));
    });
  };

  register(IDENTITY_IPC_CHANNELS.getState, (args) => {
    requireNoPayload(args);
    return options.controller.getState();
  });
  register(IDENTITY_IPC_CHANNELS.login, (args) => {
    if (args.length !== 1 || !isIdentityLoginInput(args[0])) {
      throw new TypeError("Invalid Identity login input");
    }
    return options.controller.login(args[0]);
  });
  register(IDENTITY_IPC_CHANNELS.refreshSessions, (args) => {
    requireNoPayload(args);
    return options.controller.refreshSessions();
  });
  register(IDENTITY_IPC_CHANNELS.revokeSession, (args) => {
    if (args.length !== 1 || !isIdentityRevokeSessionInput(args[0])) {
      throw new TypeError("Invalid Identity revoke input");
    }
    return options.controller.revokeSession(args[0]);
  });
  register(IDENTITY_IPC_CHANNELS.logout, (args) => {
    requireNoPayload(args);
    return options.controller.logout();
  });

  const unsubscribe = options.controller.subscribe((state) => {
    if (options.webContents.isDestroyed()) return;
    options.webContents.send(
      IDENTITY_IPC_CHANNELS.stateChanged,
      cloneIdentityPublicState(state),
    );
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    for (const channel of channels) {
      options.ipcMain.removeHandler(channel);
    }
  };
}
