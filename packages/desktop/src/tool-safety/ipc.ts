import {
  TOOL_SAFETY_IPC_CHANNELS,
  cloneToolSafetyRemoteState,
  cloneToolSafetyStateEnvelope,
  isToolSafetySubmitRequest,
  isToolSafetySurfaceQuery,
} from "./contracts.js";
import type { DesktopToolSafetyRuntime } from "./production-runtime.js";

interface ToolSafetyIpcEvent { readonly sender: unknown; readonly senderFrame: unknown }
export interface ToolSafetyIpcMain {
  handle(channel: string, handler: (event: ToolSafetyIpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
export interface ToolSafetyIpcWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, state: unknown): void;
}
function trust(event: ToolSafetyIpcEvent, webContents: ToolSafetyIpcWebContents): void {
  if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
    throw new TypeError("Tool Safety IPC requires the trusted main frame");
  }
}

export function registerToolSafetyIpc(options: Readonly<{
  ipcMain: ToolSafetyIpcMain;
  webContents: ToolSafetyIpcWebContents;
  runtime: Pick<DesktopToolSafetyRuntime, "getSurface" | "submit" | "repair" | "subscribe">;
}>): () => void {
  options.ipcMain.handle(TOOL_SAFETY_IPC_CHANNELS.getSurface, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isToolSafetySurfaceQuery(args[0])) throw new TypeError("Invalid Tool Safety query");
    return cloneToolSafetyRemoteState(await options.runtime.getSurface(args[0]));
  });
  options.ipcMain.handle(TOOL_SAFETY_IPC_CHANNELS.submit, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isToolSafetySubmitRequest(args[0])) throw new TypeError("Invalid Tool Safety request");
    return cloneToolSafetyRemoteState(await options.runtime.submit(args[0]));
  });
  options.ipcMain.handle(TOOL_SAFETY_IPC_CHANNELS.repair, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isToolSafetySurfaceQuery(args[0])) throw new TypeError("Invalid Tool Safety repair");
    return cloneToolSafetyRemoteState(await options.runtime.repair(args[0]));
  });
  const unsubscribe = options.runtime.subscribe((value) => {
    if (!options.webContents.isDestroyed()) {
      options.webContents.send(TOOL_SAFETY_IPC_CHANNELS.stateChanged, cloneToolSafetyStateEnvelope(value));
    }
  });
  return () => {
    unsubscribe();
    options.ipcMain.removeHandler(TOOL_SAFETY_IPC_CHANNELS.getSurface);
    options.ipcMain.removeHandler(TOOL_SAFETY_IPC_CHANNELS.submit);
    options.ipcMain.removeHandler(TOOL_SAFETY_IPC_CHANNELS.repair);
  };
}
