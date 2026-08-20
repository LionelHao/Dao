import {
  parseMemoryAuthorityClientApplication,
  type MemoryAuthorityClientApplication,
  type MemoryAuthorityEpochRequest,
} from "../renderer/memory-authority/client.js";
import {
  MEMORY_AUTHORITY_IPC_CHANNELS,
  cloneMemoryAuthorityContext,
  cloneMemoryAuthorityEpochRequest,
  cloneMemoryAuthorityEpochResponse,
  isMemoryAuthorityContextQuery,
  type MemoryAuthorityBridge,
  type MemoryAuthorityContextQuery,
} from "./contracts.js";

type Listener = (event: unknown, input: unknown) => void;
export interface MemoryAuthorityIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): void;
  removeListener(channel: string, listener: Listener): void;
}

export function createMemoryAuthorityBridge(
  ipcRenderer: MemoryAuthorityIpcRenderer,
): MemoryAuthorityBridge {
  return Object.freeze({
    async context(query: MemoryAuthorityContextQuery) {
      if (!isMemoryAuthorityContextQuery(query)) {
        throw new TypeError("Invalid Memory Authority context query");
      }
      return cloneMemoryAuthorityContext(
        await ipcRenderer.invoke(MEMORY_AUTHORITY_IPC_CHANNELS.context, structuredClone(query)),
      );
    },
    async request(input: MemoryAuthorityEpochRequest) {
      const request = cloneMemoryAuthorityEpochRequest(input);
      return cloneMemoryAuthorityEpochResponse(
        await ipcRenderer.invoke(MEMORY_AUTHORITY_IPC_CHANNELS.request, request),
      );
    },
    onAuthorityInput(listener: (input: MemoryAuthorityClientApplication) => void) {
      if (typeof listener !== "function") throw new TypeError("Invalid Memory Authority listener");
      const wrapped: Listener = (_event, input) => {
        const parsed = parseMemoryAuthorityClientApplication(input);
        if (parsed !== undefined) listener(structuredClone(parsed));
      };
      ipcRenderer.on(MEMORY_AUTHORITY_IPC_CHANNELS.authorityInput, wrapped);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(MEMORY_AUTHORITY_IPC_CHANNELS.authorityInput, wrapped);
      };
    },
  });
}
