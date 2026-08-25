import {
  INVOCATION_IPC_CHANNELS,
  cloneInvocationControlResult,
  cloneInvocationStateEnvelope,
  cloneInvocationSurfaceState,
  isInvocationControlRequest,
  isInvocationStateEnvelope,
  isInvocationSurfaceQuery,
  type InvocationBridge,
  type InvocationControlRequest,
  type InvocationStateEnvelope,
  type InvocationSurfaceQuery,
} from "./contracts.js";

type Listener = (event: unknown, value: unknown) => void;
export interface InvocationIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): void;
  removeListener(channel: string, listener: Listener): void;
}

export function createInvocationBridge(ipcRenderer: InvocationIpcRenderer): InvocationBridge {
  const control = async (kind: "cancel" | "retry", request: InvocationControlRequest) => {
    if (!isInvocationControlRequest(request)) throw new TypeError(`Invalid Invocation ${kind} request`);
    return cloneInvocationControlResult(await ipcRenderer.invoke(INVOCATION_IPC_CHANNELS[kind], request));
  };
  return Object.freeze({
    async getSurface(query: InvocationSurfaceQuery) {
      if (!isInvocationSurfaceQuery(query)) throw new TypeError("Invalid Invocation query");
      return cloneInvocationSurfaceState(await ipcRenderer.invoke(INVOCATION_IPC_CHANNELS.getSurface, query));
    },
    cancel: (request: InvocationControlRequest) => control("cancel", request),
    retry: (request: InvocationControlRequest) => control("retry", request),
    onStateChanged(listener: (state: InvocationStateEnvelope) => void) {
      if (typeof listener !== "function") throw new TypeError("Invocation listener is invalid");
      const wrapped: Listener = (_event, value) => {
        if (isInvocationStateEnvelope(value)) listener(cloneInvocationStateEnvelope(value));
      };
      ipcRenderer.on(INVOCATION_IPC_CHANNELS.stateChanged, wrapped);
      return () => ipcRenderer.removeListener(INVOCATION_IPC_CHANNELS.stateChanged, wrapped);
    },
  });
}
