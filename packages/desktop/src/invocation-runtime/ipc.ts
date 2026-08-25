import type { InvocationController } from "./controller.js";
import {
  INVOCATION_IPC_CHANNELS,
  cloneInvocationControlResult,
  cloneInvocationStateEnvelope,
  cloneInvocationSurfaceState,
  isInvocationControlRequest,
  isInvocationSurfaceQuery,
} from "./contracts.js";

interface InvocationIpcEvent { readonly sender: unknown; readonly senderFrame: unknown }
export interface InvocationIpcMain {
  handle(channel: string, handler: (event: InvocationIpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
export interface InvocationIpcWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, state: unknown): void;
}

function trust(event: InvocationIpcEvent, webContents: InvocationIpcWebContents): void {
  if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
    throw new TypeError("Invocation IPC requires the trusted main frame");
  }
}

export function registerInvocationIpc(options: {
  readonly ipcMain: InvocationIpcMain;
  readonly webContents: InvocationIpcWebContents;
  readonly controller: Pick<InvocationController, "getSurface" | "cancel" | "retry" | "subscribe">;
}): () => void {
  options.ipcMain.handle(INVOCATION_IPC_CHANNELS.getSurface, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isInvocationSurfaceQuery(args[0])) throw new TypeError("Invalid Invocation query");
    return cloneInvocationSurfaceState(await options.controller.getSurface(args[0]));
  });
  for (const kind of ["cancel", "retry"] as const) {
    options.ipcMain.handle(INVOCATION_IPC_CHANNELS[kind], async (event, ...args) => {
      trust(event, options.webContents);
      if (args.length !== 1 || !isInvocationControlRequest(args[0])) {
        throw new TypeError(`Invalid Invocation ${kind} request`);
      }
      return cloneInvocationControlResult(await options.controller[kind](args[0]));
    });
  }
  const unsubscribe = options.controller.subscribe((state) => {
    if (!options.webContents.isDestroyed()) {
      options.webContents.send(INVOCATION_IPC_CHANNELS.stateChanged, cloneInvocationStateEnvelope(state));
    }
  });
  return () => {
    unsubscribe();
    options.ipcMain.removeHandler(INVOCATION_IPC_CHANNELS.getSurface);
    options.ipcMain.removeHandler(INVOCATION_IPC_CHANNELS.cancel);
    options.ipcMain.removeHandler(INVOCATION_IPC_CHANNELS.retry);
  };
}
