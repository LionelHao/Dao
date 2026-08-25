import type { ProjectLoopBridge } from "./contracts.js";
import {
  PROJECT_LOOP_IPC_CHANNELS,
  cloneProjectLoopRemoteState,
  cloneProjectLoopSubmitCommand,
  isProjectLoopRemoteState,
  isProjectLoopSurfaceQuery,
} from "./contracts.js";

type Listener = (event: unknown, input: unknown) => void;
export interface ProjectLoopIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): void;
  removeListener(channel: string, listener: Listener): void;
}

export function createProjectLoopBridge(ipcRenderer: ProjectLoopIpcRenderer): ProjectLoopBridge {
  return Object.freeze({
    async getSurface(query: Parameters<ProjectLoopBridge["getSurface"]>[0]) {
      if (!isProjectLoopSurfaceQuery(query)) throw new TypeError("Invalid Project Loop query");
      return cloneProjectLoopRemoteState(
        await ipcRenderer.invoke(PROJECT_LOOP_IPC_CHANNELS.surface, structuredClone(query)),
      );
    },
    async submit(command: Parameters<ProjectLoopBridge["submit"]>[0]) {
      return cloneProjectLoopRemoteState(await ipcRenderer.invoke(
        PROJECT_LOOP_IPC_CHANNELS.submit,
        cloneProjectLoopSubmitCommand(command),
      ));
    },
    onStateChanged(listener: Parameters<ProjectLoopBridge["onStateChanged"]>[0]) {
      if (typeof listener !== "function") throw new TypeError("Invalid Project Loop listener");
      const wrapped: Listener = (_event, input) => {
        if (typeof input !== "object" || input === null || !("roomId" in input) || !("state" in input) ||
            !isProjectLoopSurfaceQuery({ roomId: input.roomId }) || !isProjectLoopRemoteState(input.state)) return;
        listener(structuredClone(input) as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(PROJECT_LOOP_IPC_CHANNELS.stateChanged, wrapped);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(PROJECT_LOOP_IPC_CHANNELS.stateChanged, wrapped);
      };
    },
  });
}
