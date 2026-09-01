import {
  DIAGNOSTICS_IPC_CHANNELS,
  cloneDiagnosticsSaveResult,
  type DiagnosticsBridge,
} from "./contracts.js";

export interface DiagnosticsIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
}

export function createDiagnosticsBridge(ipc: DiagnosticsIpcRenderer): DiagnosticsBridge {
  return Object.freeze({
    async save() {
      return cloneDiagnosticsSaveResult(await ipc.invoke(DIAGNOSTICS_IPC_CHANNELS.save));
    },
  });
}
