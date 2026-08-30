import {
  TOOL_SAFETY_IPC_CHANNELS,
  cloneToolSafetyRemoteState,
  cloneToolSafetyStateEnvelope,
  isToolSafetyStateEnvelope,
  isToolSafetySubmitRequest,
  isToolSafetySurfaceQuery,
  type ToolSafetyBridge,
  type ToolSafetyStateEnvelope,
  type ToolSafetySubmitRequest,
  type ToolSafetySurfaceQuery,
} from "./contracts.js";

type Listener = (event: unknown, value: unknown) => void;
export interface ToolSafetyIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): void;
  removeListener(channel: string, listener: Listener): void;
}

export function createToolSafetyBridge(ipcRenderer: ToolSafetyIpcRenderer): ToolSafetyBridge {
  const query = async (kind: "getSurface" | "repair", value: ToolSafetySurfaceQuery) => {
    if (!isToolSafetySurfaceQuery(value)) throw new TypeError("Invalid Tool Safety query");
    return cloneToolSafetyRemoteState(await ipcRenderer.invoke(TOOL_SAFETY_IPC_CHANNELS[kind], value));
  };
  return Object.freeze({
    getSurface: (value: ToolSafetySurfaceQuery) => query("getSurface", value),
    async submit(value: ToolSafetySubmitRequest) {
      if (!isToolSafetySubmitRequest(value)) throw new TypeError("Invalid Tool Safety request");
      return cloneToolSafetyRemoteState(await ipcRenderer.invoke(TOOL_SAFETY_IPC_CHANNELS.submit, value));
    },
    repair: (value: ToolSafetySurfaceQuery) => query("repair", value),
    onStateChanged(listener: (state: ToolSafetyStateEnvelope) => void) {
      if (typeof listener !== "function") throw new TypeError("Tool Safety listener is invalid");
      const wrapped: Listener = (_event, value) => {
        if (isToolSafetyStateEnvelope(value)) listener(cloneToolSafetyStateEnvelope(value));
      };
      ipcRenderer.on(TOOL_SAFETY_IPC_CHANNELS.stateChanged, wrapped);
      return () => ipcRenderer.removeListener(TOOL_SAFETY_IPC_CHANNELS.stateChanged, wrapped);
    },
  });
}
