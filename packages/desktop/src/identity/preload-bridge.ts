import {
  IDENTITY_IPC_CHANNELS,
  cloneIdentityPublicState,
  isIdentityLoginInput,
  isIdentityRevokeSessionInput,
  type IdentityBridge,
  type IdentityPublicState,
} from "./contracts.js";

type IdentityStateListener = (event: unknown, state: unknown) => void;

export interface IdentityIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: string, listener: IdentityStateListener): void;
  removeListener(channel: string, listener: IdentityStateListener): void;
}

async function invokeState(
  ipcRenderer: IdentityIpcRenderer,
  channel: string,
  ...args: readonly unknown[]
): Promise<IdentityPublicState> {
  return cloneIdentityPublicState(await ipcRenderer.invoke(channel, ...args));
}

export function createIdentityBridge(ipcRenderer: IdentityIpcRenderer): IdentityBridge {
  const bridge: IdentityBridge = {
    getState() {
      return invokeState(ipcRenderer, IDENTITY_IPC_CHANNELS.getState);
    },
    login(input) {
      if (!isIdentityLoginInput(input)) {
        return Promise.reject(new TypeError("Invalid Identity login input"));
      }
      return invokeState(ipcRenderer, IDENTITY_IPC_CHANNELS.login, input);
    },
    refreshSessions() {
      return invokeState(ipcRenderer, IDENTITY_IPC_CHANNELS.refreshSessions);
    },
    revokeSession(input) {
      if (!isIdentityRevokeSessionInput(input)) {
        return Promise.reject(new TypeError("Invalid Identity revoke input"));
      }
      return invokeState(ipcRenderer, IDENTITY_IPC_CHANNELS.revokeSession, input);
    },
    logout() {
      return invokeState(ipcRenderer, IDENTITY_IPC_CHANNELS.logout);
    },
    onStateChanged(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("Identity state listener must be a function");
      }
      const wrapped: IdentityStateListener = (_event, value) => {
        let state: IdentityPublicState;
        try {
          state = cloneIdentityPublicState(value);
        } catch {
          return;
        }
        listener(state);
      };
      ipcRenderer.on(IDENTITY_IPC_CHANNELS.stateChanged, wrapped);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(IDENTITY_IPC_CHANNELS.stateChanged, wrapped);
      };
    },
  };
  return Object.freeze(bridge);
}
