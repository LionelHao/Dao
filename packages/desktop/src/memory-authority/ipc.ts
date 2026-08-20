import type { DesktopMemoryAuthorityRuntime } from "./production-runtime.js";
import {
  MEMORY_AUTHORITY_IPC_CHANNELS,
  cloneMemoryAuthorityContext,
  cloneMemoryAuthorityEpochRequest,
  cloneMemoryAuthorityEpochResponse,
  isMemoryAuthorityContextQuery,
} from "./contracts.js";

interface IpcEvent { readonly sender: unknown; readonly senderFrame: unknown }
export interface MemoryAuthorityIpcMain {
  handle(channel: string, handler: (event: IpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
export interface MemoryAuthorityIpcWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, input: unknown): void;
}

function trust(event: IpcEvent, webContents: MemoryAuthorityIpcWebContents): void {
  if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
    throw new TypeError("Memory Authority IPC requires the trusted main frame");
  }
}

export function registerMemoryAuthorityIpc(options: {
  readonly ipcMain: MemoryAuthorityIpcMain;
  readonly webContents: MemoryAuthorityIpcWebContents;
  readonly runtime: DesktopMemoryAuthorityRuntime;
}): () => void {
  options.ipcMain.handle(MEMORY_AUTHORITY_IPC_CHANNELS.context, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isMemoryAuthorityContextQuery(args[0])) {
      throw new TypeError("Invalid Memory Authority context query");
    }
    return cloneMemoryAuthorityContext(await options.runtime.context(args[0]));
  });
  options.ipcMain.handle(MEMORY_AUTHORITY_IPC_CHANNELS.request, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1) throw new TypeError("Invalid Memory Authority request");
    const request = cloneMemoryAuthorityEpochRequest(args[0]);
    return cloneMemoryAuthorityEpochResponse(await options.runtime.request(request));
  });
  const unsubscribe = options.runtime.subscribe((input) => {
    if (!options.webContents.isDestroyed()) {
      options.webContents.send(MEMORY_AUTHORITY_IPC_CHANNELS.authorityInput, structuredClone(input));
    }
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    options.ipcMain.removeHandler(MEMORY_AUTHORITY_IPC_CHANNELS.context);
    options.ipcMain.removeHandler(MEMORY_AUTHORITY_IPC_CHANNELS.request);
  };
}
