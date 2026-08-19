import type { GovernanceController } from "./controller.js";
import {
  GOVERNANCE_IPC_CHANNELS,
  cloneDepartureConflictList,
  cloneGovernanceRemoteState,
  cloneGovernanceStateEnvelope,
  cloneGovernanceSubmitResult,
  isGovernanceDepartureQuery,
  isGovernanceMutationRequest,
  isGovernanceSurfaceQuery,
} from "./contracts.js";

interface GovernanceIpcEvent { readonly sender: unknown; readonly senderFrame: unknown }
export interface GovernanceIpcMain {
  handle(channel: string, handler: (event: GovernanceIpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
export interface GovernanceIpcWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, state: unknown): void;
}

function trust(event: GovernanceIpcEvent, webContents: GovernanceIpcWebContents): void {
  if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
    throw new TypeError("Governance IPC requires the trusted main frame");
  }
}

export function registerGovernanceIpc(options: {
  readonly ipcMain: GovernanceIpcMain;
  readonly webContents: GovernanceIpcWebContents;
  readonly controller: Pick<GovernanceController,
    "getSurface" | "getDepartureConflicts" | "submit" | "subscribe">;
}): () => void {
  options.ipcMain.handle(GOVERNANCE_IPC_CHANNELS.getSurface, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isGovernanceSurfaceQuery(args[0])) {
      throw new TypeError("Invalid Governance surface query");
    }
    return cloneGovernanceRemoteState(await options.controller.getSurface(args[0]));
  });
  options.ipcMain.handle(GOVERNANCE_IPC_CHANNELS.getDepartureConflicts, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isGovernanceDepartureQuery(args[0])) {
      throw new TypeError("Invalid Governance conflicts query");
    }
    return cloneDepartureConflictList(await options.controller.getDepartureConflicts(args[0]));
  });
  options.ipcMain.handle(GOVERNANCE_IPC_CHANNELS.submit, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isGovernanceMutationRequest(args[0])) {
      throw new TypeError("Invalid Governance mutation request");
    }
    return cloneGovernanceSubmitResult(options.controller.submit(args[0]));
  });
  const unsubscribe = options.controller.subscribe((state) => {
    if (options.webContents.isDestroyed()) return;
    options.webContents.send(
      GOVERNANCE_IPC_CHANNELS.stateChanged,
      cloneGovernanceStateEnvelope(state),
    );
  });
  const channels = [
    GOVERNANCE_IPC_CHANNELS.getSurface,
    GOVERNANCE_IPC_CHANNELS.getDepartureConflicts,
    GOVERNANCE_IPC_CHANNELS.submit,
  ] as const;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    for (const channel of channels) options.ipcMain.removeHandler(channel);
  };
}
