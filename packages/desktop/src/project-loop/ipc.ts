import type { DesktopProjectLoopRuntime } from "./production-runtime.js";
import {
  PROJECT_LOOP_IPC_CHANNELS,
  cloneProjectLoopRemoteState,
  cloneProjectLoopSubmitCommand,
  isProjectLoopSurfaceQuery,
} from "./contracts.js";

interface IpcEvent { readonly sender: unknown; readonly senderFrame: unknown }
export interface ProjectLoopIpcMain {
  handle(channel: string, handler: (event: IpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
export interface ProjectLoopIpcWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, input: unknown): void;
}
function trust(event: IpcEvent, webContents: ProjectLoopIpcWebContents): void {
  if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
    throw new TypeError("Project Loop IPC requires the trusted main frame");
  }
}

export function registerProjectLoopIpc(options: Readonly<{
  ipcMain: ProjectLoopIpcMain;
  webContents: ProjectLoopIpcWebContents;
  runtime: DesktopProjectLoopRuntime;
}>): () => void {
  options.ipcMain.handle(PROJECT_LOOP_IPC_CHANNELS.surface, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isProjectLoopSurfaceQuery(args[0])) {
      throw new TypeError("Invalid Project Loop surface query");
    }
    return cloneProjectLoopRemoteState(await options.runtime.getSurface(args[0]));
  });
  options.ipcMain.handle(PROJECT_LOOP_IPC_CHANNELS.submit, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1) throw new TypeError("Invalid Project Loop submit command");
    const command = cloneProjectLoopSubmitCommand(args[0]);
    return cloneProjectLoopRemoteState(await options.runtime.submit(command));
  });
  const unsubscribe = options.runtime.subscribe((input) => {
    if (!options.webContents.isDestroyed()) {
      options.webContents.send(PROJECT_LOOP_IPC_CHANNELS.stateChanged, structuredClone(input));
    }
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    options.ipcMain.removeHandler(PROJECT_LOOP_IPC_CHANNELS.surface);
    options.ipcMain.removeHandler(PROJECT_LOOP_IPC_CHANNELS.submit);
  };
}
